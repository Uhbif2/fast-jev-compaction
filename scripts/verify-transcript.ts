/**
 * Checks what the engine wrote after the last compaction of a transcript and
 * what a reload of it would load. Prints counts only, never content.
 *
 *   npx tsx scripts/verify-transcript.ts <session.jsonl>
 *
 * The load model follows Claude Code 2.1.280: the chain from the newest entry
 * by parentUuid, plus the parallel-result recovery that pulls in every entry
 * of the file sharing an assistant `message.id` with the chain, and every
 * tool_result whose parent is one of those entries.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Block = { type?: string; id?: string; tool_use_id?: string };
type Row = {
  uuid?: string; parentUuid?: string | null; type?: string; subtype?: string; isSidechain?: boolean;
  message?: { id?: string; content?: string | Block[] }; compactMetadata?: Record<string, unknown>;
};

const blocks = (row: Row): Block[] => (Array.isArray(row.message?.content) ? row.message.content : []);
const hasResult = (row: Row) => row.type === 'user' && blocks(row).some((b) => b.type === 'tool_result');

export function verifyTranscript(rows: readonly Row[]) {
  const boundary = rows.findLastIndex((row) => row.subtype === 'compact_boundary');
  const index = new Map(rows.flatMap((row, i) => (row.uuid ? [[row.uuid, i] as const] : [])));
  const after = boundary >= 0 ? rows.slice(boundary + 1) : [];
  const linksIntoHistory = after.filter((row) => row.parentUuid && (index.get(row.parentUuid) ?? Infinity) < boundary).length;
  const oldIds = new Set(rows.slice(0, Math.max(0, boundary)).filter((r) => r.type === 'assistant').map((r) => r.message?.id));
  const sharedMessageIds = after.filter((r) => r.type === 'assistant' && oldIds.has(r.message?.id)).length;

  const byUuid = new Map(rows.filter((r) => r.uuid).map((r) => [r.uuid!, r]));
  const leaf = rows.findLast((r) => !r.isSidechain && (r.type === 'user' || r.type === 'assistant'));
  const chain: Row[] = [];
  const seen = new Set<string>();
  for (let row = leaf; row?.uuid && !seen.has(row.uuid); row = row.parentUuid ? byUuid.get(row.parentUuid) : undefined) {
    seen.add(row.uuid);
    chain.push(row);
  }
  chain.reverse();
  const byMessageId = new Map<string, Row[]>();
  const resultsByParent = new Map<string, Row[]>();
  for (const row of rows) {
    const id = row.type === 'assistant' ? row.message?.id : undefined;
    if (id) byMessageId.set(id, [...(byMessageId.get(id) ?? []), row]);
    if (hasResult(row) && row.parentUuid) resultsByParent.set(row.parentUuid, [...(resultsByParent.get(row.parentUuid) ?? []), row]);
  }
  let recovered = 0;
  for (const row of chain.filter((r) => r.type === 'assistant')) {
    for (const sibling of byMessageId.get(row.message?.id ?? '') ?? []) {
      if (!seen.has(sibling.uuid!)) recovered += 1;
      for (const result of resultsByParent.get(sibling.uuid!) ?? []) if (!seen.has(result.uuid!)) recovered += 1;
    }
  }
  const uses = new Map<string, number>();
  const results = new Map<string, number>();
  for (const row of chain) for (const block of blocks(row)) {
    if (block.type === 'tool_use' && block.id) uses.set(block.id, (uses.get(block.id) ?? 0) + 1);
    if (block.type === 'tool_result' && block.tool_use_id) results.set(block.tool_use_id, (results.get(block.tool_use_id) ?? 0) + 1);
  }
  return {
    rows: rows.length,
    boundary,
    compactMetadata: boundary >= 0 ? rows[boundary]!.compactMetadata : undefined,
    linksIntoHistory,
    sharedMessageIds,
    chainStartsAfterBoundary: boundary < 0 || (index.get(chain[0]?.uuid ?? '') ?? -1) >= boundary,
    recoveredOnReload: recovered,
    duplicateToolUses: [...uses.values()].filter((n) => n > 1).length,
    duplicateResults: [...results.values()].filter((n) => n > 1).length,
    callsWithoutResult: [...uses.keys()].filter((id) => !results.has(id)).length,
    thinkingBlocksInChain: chain.reduce((n, row) => n + blocks(row).filter((b) => b.type === 'thinking').length, 0),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: npx tsx scripts/verify-transcript.ts <session.jsonl>');
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Row);
  const report = verifyTranscript(rows);
  console.log(JSON.stringify(report, null, 1));
  const clean = report.linksIntoHistory === 0 && report.sharedMessageIds === 0 && report.chainStartsAfterBoundary &&
    report.recoveredOnReload === 0 && report.duplicateToolUses === 0 && report.duplicateResults === 0;
  if (!clean) process.exitCode = 1;
}
